import assert from "node:assert/strict";
import test from "node:test";
import { serializeCV, stringAsciiCV, tupleCV, uintCV, principalCV, listCV, someCV } from "@stacks/transactions";
import {
  bindingsFromSponsorEvents,
  extractedPotDetails,
  filterPotsForDetails,
  initPayloadFromEvent,
  initPotPrintForPot,
  initPotPrintsForSponsor,
  potMatchesOwner,
  potMatchesSponsor,
  potsSponsoredBy,
  preInitRowsForOwner,
  sponsorsFromPrintLogs,
} from "./potDetails.js";

const OWNER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const OTHER = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const POT = `${OWNER}.jackpot`;
const SPONSOR = `${OTHER}.stackspot-sponsor`;

const pots = [
  {
    potAddress: POT,
    potOwner: OWNER,
    potAdmin: OWNER,
    potType: "jackpot",
    values: { sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }] },
  },
  {
    potAddress: `${OTHER}.sequential`,
    potOwner: OTHER,
    potAdmin: OTHER,
    potType: "sequential",
    values: {},
  },
];

test("pot details keep only values decoded from result hex", () => {
  const details = {
    network: "testnet",
    contractId: "ST300KR5ZKJCGQGSFF84CNAQ3V557CNXWM94PFDG5.sequential",
    address: "ST300KR5ZKJCGQGSFF84CNAQ3V557CNXWM94PFDG5",
    name: "sequential",
    function: "get-pot-details",
    sender: "ST300KR5ZKJCGQGSFF84CNAQ3V557CNXWM94PFDG5",
    args: [],
    okay: true,
    ok: true,
    values: {
      "is-joined": null,
      "pot-value": "0",
      "pot-locked": false,
      "pool-config": { "join-end": "15800" },
    },
    error: null,
  };
  const wrap = (functionName, values, extra = {}) => ({
    network: "testnet",
    contractId: "ST300KR5ZKJCGQGSFF84CNAQ3V557CNXWM94PFDG5.sequential",
    function: functionName,
    sender: "ST300KR5ZKJCGQGSFF84CNAQ3V557CNXWM94PFDG5",
    args: extra.args ?? [],
    okay: true,
    ok: true,
    values,
    error: null,
  });
  const extracted = extractedPotDetails(details, {
    "get-pot-is-init": wrap("get-pot-is-init", false),
    "get-pot-id": wrap("get-pot-id", null),
    "get-pot-cycle": wrap("get-pot-cycle", "0"),
    "get-pot-name": wrap("get-pot-name", ""),
    "get-pot-min-amount": wrap("get-pot-min-amount", "100000000"),
    "get-pot-max-participants": wrap("get-pot-max-participants", "100"),
    "is-contract-allowed-hash": wrap("is-contract-allowed-hash", true, {
      args: ["0x061ac009"],
    }),
  });
  assert.deepEqual(extracted, {
    "is-joined": null,
    "pot-value": "0",
    "pot-locked": false,
    "pool-config": { "join-end": "15800" },
    "pot-is-init": false,
    "pot-id": null,
    "pot-cycle": "0",
    "pot-name": "",
    "pot-min-amount": "100000000",
    "pot-max-participants": "100",
    "is-contract-allowed-hash": true,
  });
  assert.equal(extracted.contractId, undefined);
  assert.equal(extracted.owner, undefined);
  assert.equal(extracted.function, undefined);
  assert.equal(extracted.args, undefined);
});

test("owner filter matches pot-owner and deployer wallet", () => {
  assert.equal(potMatchesOwner(pots[0], OWNER), true);
  assert.equal(potMatchesOwner(pots[1], OWNER), false);
  assert.equal(filterPotsForDetails(pots, { owner: OWNER }).length, 1);
});

test("contract filter returns that pot even when owner also matches", () => {
  const rows = filterPotsForDetails(pots, { owner: OWNER, contract: POT });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].potAddress, POT);
});

test("sponsor filter uses init-pot sponsor-contract list or tickets", () => {
  assert.equal(potMatchesSponsor(pots[0], SPONSOR, []), true);
  assert.equal(potMatchesSponsor(pots[1], SPONSOR, []), false);
  assert.equal(
    potMatchesSponsor(pots[1], SPONSOR, [{ potContract: `${OTHER}.sequential` }]),
    true,
  );
  assert.equal(filterPotsForDetails(pots, { sponsorContract: SPONSOR }).length, 1);
});

test("owner + contract + sponsor returns the matching pot", () => {
  const rows = filterPotsForDetails(pots, {
    owner: OWNER,
    contract: POT,
    sponsorContract: SPONSOR,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].potAddress, POT);
});

test("init-pot print logs yield the logged sponsor tickets", () => {
  const print = someCV(
    tupleCV({
      event: stringAsciiCV("init-pot"),
      contract: principalCV(POT),
      sponsors: listCV([
        tupleCV({
          "sponsor-contract": principalCV(SPONSOR),
          "ticket-id": uintCV(4n),
        }),
      ]),
    }),
  );
  const serialized = serializeCV(print);
  const hex = serialized.startsWith("0x") ? serialized : `0x${serialized}`;
  const sponsors = sponsorsFromPrintLogs([{ hex }], POT);
  assert.equal(sponsors.length, 1);
  assert.equal(sponsors[0]["sponsor-contract"], SPONSOR);
  assert.equal(sponsors[0]["ticket-id"], "4");
});

test("pot-registered pot-values hex is the pots-page init payload", () => {
  const print = initPayloadFromEvent({
    event: "pot-registered",
    txid: "0xregistered",
    "pot-address": POT,
    "pot-values":
      "0x0c0000000808636f6e7472616374061a86debef2dd947196608f31e7e4ce7a171909d5cf076a61636b706f74066379636c65730100000000000000000000000000000001106d61782d7061727469636970616e747301000000000000000000000000000000640a6d696e2d616d6f756e7401000000000000000000000000017d7840056f776e6572051a86debef2dd947196608f31e7e4ce7a171909d5cf10706f742d7265776172642d746f6b656e0d00000004736274630873706f6e736f72730b000000010c000000021073706f6e736f722d636f6e7472616374061a86debef2dd947196608f31e7e4ce7a171909d5cf0b6b696e67732d7669626573097469636b65742d6964010000000000000000000000000000000104747970650d000000076a61636b706f74",
  });
  assert.equal(print.event, "init-pot");
  assert.equal(print.contract, "ST23DXFQJVPA735K0HWRYFS6EF8BHJ2ENSZ3NNNMC.jackpot");
  assert.equal(print["min-amount"], "25000000");
  assert.equal(print["max-participants"], "100");
  assert.equal(print.sponsors[0]["ticket-id"], "1");
  assert.equal(print.txid, "0xregistered");
  assert.equal(typeof print["pot-values"], "undefined");
});

test("pot init route returns that contract's init-pot print", () => {
  const print = initPotPrintForPot(
    [
      {
        event: "init-pot",
        txid: "0xinit",
        values: {
          contract: POT,
          type: "jackpot",
          cycles: "1",
          "min-amount": "25000000",
          sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }],
        },
      },
      {
        event: "init-pot",
        txid: "0xother",
        values: { contract: `${OTHER}.sequential`, type: "sequential" },
      },
    ],
    POT,
  );
  assert.equal(print.event, "init-pot");
  assert.equal(print.contract, POT);
  assert.equal(print.sponsors[0]["ticket-id"], "1");
  assert.equal(initPotPrintForPot([], `${OTHER}.missing`), null);
});

test("sponsor pots route returns only matching init-pot prints", () => {
  const prints = initPotPrintsForSponsor(
    [
      {
        event: "init-pot",
        txid: "0xinit",
        values: {
          contract: POT,
          type: "jackpot",
          cycles: "1",
          sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }],
        },
      },
      {
        event: "init-pot",
        txid: "0xinit",
        values: {
          contract: POT,
          sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }],
        },
      },
      {
        event: "init-pot",
        txid: "0xother",
        values: {
          contract: `${OTHER}.crowd-fund`,
          sponsors: [{ "sponsor-contract": `${OWNER}.other-sponsor`, "ticket-id": "2" }],
        },
      },
      {
        event: "sponsor-event",
        txid: "0xticket",
        contractId: SPONSOR,
        values: { "ticket-id": "7", "pot-contract": POT },
      },
    ],
    SPONSOR,
  );
  assert.equal(prints.length, 1);
  assert.equal(prints[0].event, "init-pot");
  assert.equal(prints[0].contract, POT);
  assert.equal(prints[0].txid, "0xinit");
  assert.equal(prints[0].sponsors[0]["ticket-id"], "1");
  assert.equal(prints[0].potAddress, undefined);
  assert.equal(prints[0]["pot-details"], undefined);
});

test("sponsor contract route bindings come from tickets and init-pot sponsors", () => {
  const events = [
    {
      event: "sponsor-event",
      contractId: SPONSOR,
      txid: "0xticket",
      values: {
        "ticket-id": "7",
        "pot-contract": `${OTHER}.sequential`,
        "pot-details": { "pot-name": "Seq" },
      },
    },
    {
      event: "init-pot",
      txid: "0xinit",
      values: {
        contract: POT,
        sponsors: [{ "sponsor-contract": SPONSOR, "ticket-id": "1" }],
      },
    },
    {
      event: "init-pot",
      txid: "0xother",
      values: {
        contract: `${OTHER}.crowd-fund`,
        sponsors: [{ "sponsor-contract": `${OWNER}.other-sponsor`, "ticket-id": "2" }],
      },
    },
  ];
  const bindings = bindingsFromSponsorEvents(events, SPONSOR);
  assert.deepEqual(
    bindings.map((row) => row.potAddress).sort(),
    [POT, `${OTHER}.sequential`].sort(),
  );
  const rows = potsSponsoredBy({ pots, events, sponsorContract: SPONSOR });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.potAddress === POT)["ticket-id"], "1");
  assert.equal(rows.find((row) => row.potAddress === `${OTHER}.sequential`)["pot-details"]["pot-name"], "Seq");
});

test("owner pots come from pre-init prints, not wallet deploys", () => {
  const owner = "ST4B1RB4STWAGXDYH05CAK2T14BBC2CJ6E1BGG7D";
  const pot = `${owner}.jackpot`;
  const rows = preInitRowsForOwner(
    [
      {
        event: "pre-init",
        txid: "0xabc",
        "pot-owner": owner,
        "pot-contract": pot,
        "pot-name": "jackpot",
        "pot-type": "jackpot",
      },
      {
        event: "pre-init",
        txid: "0xdef",
        "pot-owner": "ST23DXFQJVPA735K0HWRYFS6EF8BHJ2ENSZ3NNNMC",
        "pot-contract": "ST23DXFQJVPA735K0HWRYFS6EF8BHJ2ENSZ3NNNMC.jackpot",
      },
      {
        event: "init-pot",
        txid: "0x111",
        "pot-owner": owner,
        "pot-contract": `${owner}.other`,
      },
    ],
    owner,
  );
  assert.deepEqual(
    rows.map((row) => row.potAddress),
    [pot],
  );
  assert.equal(rows[0].lastEvent, "pre-init");
});
