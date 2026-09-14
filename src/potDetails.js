import { getCachedContract, setCachedContract, setPotLive } from "./cache.js";
import { eventPrint, eventTxId, toPublicEvent } from "./catalog.js";
import { config } from "./config.js";
import { decodeClarityResult, decodePrintHex, expandEncodedValues } from "./decoder.js";
import { serializeArgs } from "./encode.js";
import { callReadOnly, parseContractId, parseFunctionName } from "./hiro.js";
import { networkFromPrincipal } from "./network.js";
import { isPotContractId, isPreInitPotRow, normalizeListedPot } from "./pots.js";
import { isSponsorContractId } from "./sponsors.js";

function samePrincipal(a, b) {
  if (a == null || b == null || a === "" || b === "") return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function walletOf(contractId) {
  const text = String(contractId ?? "");
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(0, dot) : text;
}

function asTrimmed(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

export function parseOptionalContractId(raw, label) {
  const value = asTrimmed(raw);
  if (!value) return null;
  if (!value.includes(".")) {
    const error = new Error(`${label} must be ADDRESS.NAME`);
    error.status = 400;
    throw error;
  }
  return parseContractId(value).contractId;
}

export function parseOptionalPrincipal(raw, label) {
  const value = asTrimmed(raw);
  if (!value) return null;
  if (!/^[S][A-Z0-9]{24,40}(\.[a-zA-Z][a-zA-Z0-9_-]{0,127})?$/.test(value)) {
    const error = new Error(`${label} must be a Stacks principal`);
    error.status = 400;
    throw error;
  }
  return value;
}

function potSponsorsFromValues(values) {
  if (!values || typeof values !== "object") return [];
  const list = Array.isArray(values.sponsors) ? values.sponsors : [];
  return list
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const contract = row["sponsor-contract"] ?? row.sponsorContract ?? row.sponsor;
      return isSponsorContractId(contract) ? String(contract) : null;
    })
    .filter(Boolean);
}

export function potMatchesOwner(pot, owner) {
  if (!owner) return true;
  return (
    samePrincipal(pot.potOwner, owner) ||
    samePrincipal(pot.potAdmin, owner) ||
    samePrincipal(pot.values?.owner, owner) ||
    samePrincipal(pot.values?.["pot-owner"], owner) ||
    samePrincipal(walletOf(pot.potAddress), owner)
  );
}

export function potMatchesSponsor(pot, sponsorContract, sponsorTickets = []) {
  if (!sponsorContract) return true;
  if (samePrincipal(sponsorContract, pot.potAddress)) return false;
  const fromValues = potSponsorsFromValues(pot.values);
  if (fromValues.some((id) => samePrincipal(id, sponsorContract))) return true;
  return sponsorTickets.some((ticket) => samePrincipal(ticket.potContract, pot.potAddress));
}

function ticketIdOf(row) {
  if (!row || typeof row !== "object") return null;
  const id = row["ticket-id"] ?? row.ticketId;
  return id == null || id === "" ? null : String(id);
}

function rememberBinding(byPot, potAddress, extra) {
  if (!isPotContractId(potAddress)) return;
  const address = String(potAddress).trim();
  const key = address.toLowerCase();
  const prev = byPot.get(key);
  byPot.set(key, {
    potAddress: prev?.potAddress ?? address,
    ticketId: extra.ticketId ?? prev?.ticketId ?? null,
    potDetails: extra.potDetails ?? prev?.potDetails ?? null,
    txid: extra.txid ?? prev?.txid ?? null,
  });
}

function sponsorsFromDecoded(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  if (Array.isArray(values.sponsors)) return values.sponsors;
  const nested = values["pot-values"];
  if (typeof nested !== "string" || !nested.startsWith("0x")) return null;
  const inner = decodePrintHex(nested);
  return Array.isArray(inner.values?.sponsors) ? inner.values.sponsors : null;
}

/** Tickets logged on an init-pot print, or inside a pot-registered pot-values buffer. */
export function sponsorsFromPrintLogs(logs, potContract) {
  for (const log of logs ?? []) {
    const decoded = decodePrintHex(log?.hex);
    if (!decoded.values) continue;
    if (decoded.event === "init-pot") {
      const contract = decoded.values.contract ?? decoded.values["pot-treasury"];
      if (potContract && contract && !samePrincipal(contract, potContract)) continue;
    } else if (decoded.event !== "pot-registered") {
      continue;
    }
    const sponsors = sponsorsFromDecoded(decoded.values);
    if (Array.isArray(sponsors)) return sponsors;
  }
  return null;
}

function loggedInitPot(event) {
  return initPayloadFromEvent(event);
}

/**
 * Pots-page payload. A core-contract `init-pot` print is returned as-is.
 * `register-pot` only stores that same tuple as the `pot-values` buffer on `pot-registered`.
 */
export function initPayloadFromEvent(event) {
  const print = expandEncodedValues(eventPrint(event));
  const name = String(print.event ?? event?.event ?? "").trim();
  const txid = eventTxId(event) ?? event?.txid ?? event?.txId ?? null;
  if (name === "init-pot") {
    return toPublicEvent({
      ...event,
      event: "init-pot",
      values: print,
      txId: txid,
      txid,
    });
  }
  if (name !== "pot-registered") return null;
  const nested = print["pot-values"];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return null;
  const contract = nested.contract ?? nested["pot-treasury"] ?? print["pot-address"];
  if (!contract) return null;
  return {
    event: "init-pot",
    ...nested,
    contract,
    txid,
  };
}

/** The cached `init-pot` print for one pot contract. */
export function initPotPrintForPot(events, potAddress) {
  const want = String(potAddress ?? "").trim().toLowerCase();
  if (!want) return null;
  let match = null;
  for (const event of events ?? []) {
    const logged = loggedInitPot(event);
    if (!logged) continue;
    const contract = String(logged.contract ?? logged["pot-treasury"] ?? "").trim().toLowerCase();
    if (contract !== want) continue;
    if (!match || (Array.isArray(logged.sponsors) && logged.sponsors.length && !match.sponsors?.length)) {
      match = logged;
    }
  }
  return match;
}

/** Cached `init-pot` prints for this sponsor. Extra pot ids cover tickets whose sponsors list was not stored. */
export function initPotPrintsForSponsor(events, sponsorContract, extraPotContracts = []) {
  const extra = new Set(
    extraPotContracts.map((id) => String(id ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const seenTx = new Set();
  const seenPot = new Set();
  const out = [];
  for (const event of events ?? []) {
    const print = expandEncodedValues(eventPrint(event));
    const name = String(event?.event ?? print.event ?? "").trim();
    if (name !== "init-pot" && name !== "pot-registered") continue;
    const logged = initPayloadFromEvent({ ...event, event: name, values: print, txid: eventTxId(event) });
    if (!logged) continue;
    const contract = String(logged.contract ?? logged["pot-treasury"] ?? "").trim();
    const listed = Array.isArray(logged.sponsors)
      ? logged.sponsors.some((row) =>
          samePrincipal(row?.["sponsor-contract"] ?? row?.sponsorContract, sponsorContract),
        )
      : false;
    if (!listed && !extra.has(contract.toLowerCase())) continue;
    const txid = eventTxId(event);
    const potKey = contract.toLowerCase();
    if (txid && seenTx.has(txid)) continue;
    if (potKey && seenPot.has(potKey)) continue;
    if (txid) seenTx.add(txid);
    if (potKey) seenPot.add(potKey);
    out.push(logged);
  }
  return out;
}

/** Pot contracts bound to a sponsor via sponsor-event tickets or an init-pot sponsors list. */
export function bindingsFromSponsorEvents(events, sponsorContract) {
  const want = String(sponsorContract ?? "").trim().toLowerCase();
  const byPot = new Map();
  for (const event of events ?? []) {
    const print = eventPrint(event);
    const name = event?.event ?? print.event;
    if (name === "sponsor-event") {
      const owner = event?.contractId ?? print["sponsor-contract"];
      if (want && owner && String(owner).trim().toLowerCase() !== want) continue;
      rememberBinding(byPot, print["pot-contract"], {
        ticketId: ticketIdOf(print),
        potDetails: print["pot-details"] ?? null,
        txid: eventTxId(event),
      });
    }
    if (name === "init-pot") {
      const list = Array.isArray(print.sponsors) ? print.sponsors : [];
      const match = list.find((row) => {
        const id = row?.["sponsor-contract"] ?? row?.sponsorContract;
        return String(id ?? "").trim().toLowerCase() === want;
      });
      if (!match) continue;
      rememberBinding(byPot, print.contract ?? print["pot-treasury"] ?? print["pot-contract"], {
        ticketId: ticketIdOf(match),
        txid: eventTxId(event),
      });
    }
  }
  return [...byPot.values()];
}

function withSponsorBinding(pot, binding) {
  const base = pot
    ? (normalizeListedPot(pot) ?? pot)
    : {
        potAddress: binding?.potAddress ?? null,
        status: null,
        values:
          binding?.potDetails && typeof binding.potDetails === "object" && !Array.isArray(binding.potDetails)
            ? { ...binding.potDetails }
            : {},
      };
  if (!base?.potAddress) return null;
  return {
    ...base,
    ...(binding?.ticketId != null ? { "ticket-id": binding.ticketId } : {}),
    ...(binding?.potDetails != null ? { "pot-details": binding.potDetails } : {}),
    ...(binding?.txid ? { sponsorTicketTxid: binding.txid } : {}),
  };
}

export function potsSponsoredBy({ pots = [], events = [], sponsorContract, tickets = [] } = {}) {
  const bindings = bindingsFromSponsorEvents(events, sponsorContract);
  const ticketRows = [
    ...bindings.map((row) => ({ potContract: row.potAddress, ticketId: row.ticketId })),
    ...(Array.isArray(tickets) ? tickets : []),
  ];
  const matched = filterPotsForDetails(pots, { sponsorContract, sponsorTickets: ticketRows });
  const byAddress = new Map(
    matched.map((pot) => [String(pot.potAddress).trim().toLowerCase(), pot]),
  );
  const extras = new Map(bindings.map((row) => [row.potAddress.trim().toLowerCase(), row]));
  const seen = new Set();
  const out = [];
  for (const binding of bindings) {
    const key = binding.potAddress.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = withSponsorBinding(byAddress.get(key), binding);
    if (row) out.push(row);
  }
  for (const pot of matched) {
    const key = String(pot.potAddress).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const row = withSponsorBinding(pot, extras.get(key));
    if (row) out.push(row);
  }
  return out;
}

export function filterPotsForDetails(pots, { owner, contract, sponsorContract, sponsorTickets = [] } = {}) {
  let rows = Array.isArray(pots) ? pots.filter((pot) => pot?.potAddress) : [];
  if (contract) {
    rows = rows.filter((pot) => samePrincipal(pot.potAddress, contract));
  }
  if (owner) {
    rows = rows.filter((pot) => potMatchesOwner(pot, owner));
  }
  if (sponsorContract) {
    rows = rows.filter((pot) => potMatchesSponsor(pot, sponsorContract, sponsorTickets));
  }
  return rows;
}

/** Owner feed: cached `pre-init` prints whose `pot-owner` is that address. */
export function preInitRowsForOwner(events, owner) {
  const want = String(owner ?? "").trim().toLowerCase();
  if (!want) return [];
  const byContract = new Map();
  for (const event of events ?? []) {
    if (event?.event !== "pre-init") continue;
    if (String(event["pot-owner"] ?? "").trim().toLowerCase() !== want) continue;
    const potAddress = event["pot-contract"] ?? event["pot-treasury"] ?? event.contract;
    if (!isPotContractId(potAddress)) continue;
    const key = String(potAddress).trim().toLowerCase();
    if (byContract.has(key)) continue;
    byContract.set(key, {
      potAddress: String(potAddress),
      potOwner: event["pot-owner"] ?? owner,
      potType: event["pot-type"] ?? null,
      potName: event["pot-name"] ?? null,
      lastEvent: "pre-init",
      values: event,
    });
  }
  return [...byContract.values()];
}

function omitClarity(row) {
  if (!row || typeof row !== "object") return row;
  const { clarity, ...rest } = row;
  return rest;
}

function readPayload(parsed, functionName, sender, argHexes, read, decoded, ctx) {
  return {
    network: networkFromPrincipal(parsed.address) ?? ctx.network,
    contractId: parsed.contractId,
    address: parsed.address,
    name: parsed.name,
    function: functionName,
    sender,
    args: argHexes,
    okay: read.okay,
    ok: decoded.ok,
    values: decoded.values,
    error: decoded.error ?? decoded.decodeError ?? null,
  };
}

export async function readCachedFunction({
  contractId,
  functionName,
  sender,
  args = [],
  refresh = false,
  ctx,
}) {
  const parsed = parseContractId(contractId);
  const fn = parseFunctionName(functionName);
  const from = String(sender || parsed.address);
  const argHexes = serializeArgs(args);
  const cacheKey = `${parsed.contractId}:${fn}:${from}:${argHexes.join(",")}`;

  if (!refresh) {
    const cached = await getCachedContract(cacheKey, ctx);
    if (cached) return omitClarity(cached);
  }

  try {
    const read = await callReadOnly({
      address: parsed.address,
      name: parsed.name,
      functionName: fn,
      sender: from,
      arguments: argHexes,
    });
    const decoded = decodeClarityResult(read.result);
    const payload = readPayload(parsed, fn, from, argHexes, read, decoded, ctx);
    await setCachedContract(cacheKey, payload, ctx);
    return payload;
  } catch (error) {
    return {
      network: ctx.network,
      contractId: parsed.contractId,
      address: parsed.address,
      name: parsed.name,
      function: fn,
      sender: from,
      args: argHexes,
      okay: false,
      ok: false,
      values: null,
      error: error.message ?? "Read-only contract call failed",
    };
  }
}

async function optionalRead(options) {
  return readCachedFunction(options);
}

const EXTRA_FIELDS = {
  "get-pot-is-init": "pot-is-init",
  "get-pot-id": "pot-id",
  "get-pot-cycle": "pot-cycle",
  "get-pot-name": "pot-name",
  "get-pot-min-amount": "pot-min-amount",
  "get-pot-max-participants": "pot-max-participants",
  "get-next-payment-id": "next-payment-id",
  "get-pot-session-status": "pot-session-status",
  "is-contract-allowed-hash": "is-contract-allowed-hash",
  "get-platform-sponsor-ticket": "platform-sponsor-ticket",
};

function readValue(row) {
  if (!row || typeof row !== "object") return { ok: false, value: undefined };
  if (row.ok === false || row.okay === false) return { ok: false, value: undefined };
  if (!("values" in row)) return { ok: false, value: undefined };
  return { ok: true, value: row.values };
}

/** Decoded read-only values only. Call metadata is not part of the result hex. */
export function extractedPotDetails(details, extras = {}) {
  const out = {};
  const detail = readValue(details);
  if (detail.ok && detail.value && typeof detail.value === "object" && !Array.isArray(detail.value)) {
    Object.assign(out, detail.value);
  }
  for (const [fn, field] of Object.entries(EXTRA_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(extras, fn)) continue;
    const read = readValue(extras[fn]);
    if (!read.ok) continue;
    out[field] = read.value;
  }
  return out;
}

export async function loadLivePotDetails({
  pot,
  contractId,
  owner,
  sponsorContract,
  stackspotsContract,
  refresh = false,
  ctx,
}) {
  const target = contractId ?? pot?.potAddress;
  if (!isPotContractId(target)) {
    const error = new Error("contract must be ADDRESS.NAME");
    error.status = 400;
    throw error;
  }

  const sender = owner || walletOf(target);
  const potType = String(pot?.potType ?? pot?.values?.["pot-type"] ?? pot?.values?.type ?? "").toLowerCase();

  const extraNames = [
    "get-pot-is-init",
    "get-pot-id",
    "get-pot-cycle",
    "get-pot-name",
    "get-pot-min-amount",
    "get-pot-max-participants",
  ];
  if (potType.includes("sequential")) {
    extraNames.push("get-next-payment-id", "get-pot-session-status");
  }

  const extraJobs = extraNames.map((functionName) =>
    optionalRead({
      contractId: target,
      functionName,
      sender,
      refresh,
      ctx,
    }).then((row) => [functionName, row]),
  );
  if (stackspotsContract) {
    extraJobs.push(
      optionalRead({
        contractId: stackspotsContract,
        functionName: "is-contract-allowed-hash",
        sender,
        args: [{ type: "principal", value: target }],
        refresh,
        ctx,
      }).then((row) => ["is-contract-allowed-hash", row]),
    );
  }
  if (sponsorContract) {
    extraJobs.push(
      optionalRead({
        contractId: target,
        functionName: "get-platform-sponsor-ticket",
        sender,
        args: [{ type: "principal", value: sponsorContract }],
        refresh,
        ctx,
      }).then((row) => ["get-platform-sponsor-ticket", row]),
    );
  }

  const [details, extraPairs] = await Promise.all([
    readCachedFunction({
      contractId: target,
      functionName: "get-pot-details",
      sender,
      refresh,
      ctx,
    }),
    Promise.all(extraJobs),
  ]);
  const extras = Object.fromEntries(extraPairs.map(([name, row]) => [name, omitClarity(row)]));
  const values = extractedPotDetails(details, extras);
  if (Object.keys(values).length > 0) {
    await setPotLive(target, values, ctx);
  }
  return {
    values,
    hasDecoded: Object.keys(values).length > 0,
  };
}

export const POT_DETAILS_MAX = Number(process.env.POT_DETAILS_MAX ?? 40);

export async function collectPotDetails({
  owner,
  contract,
  sponsorContract,
  pots,
  sponsor,
  refresh = false,
  ctx,
}) {
  const listed = Array.isArray(pots) ? pots.filter((pot) => pot?.potAddress) : [];
  let matched = filterPotsForDetails(listed, {
    owner,
    contract,
    sponsorContract,
    sponsorTickets: sponsor?.tickets ?? [],
  });

  if (contract && matched.length === 0) {
    matched = [{ potAddress: contract, potOwner: owner ?? null, values: {} }];
  }

  if (owner && !contract) {
    matched = matched.filter(isPreInitPotRow);
  }

  const limited = matched.slice(0, POT_DETAILS_MAX);
  const loaded = await Promise.all(
    limited.map((pot) =>
      loadLivePotDetails({
        pot,
        contractId: pot.potAddress,
        owner,
        sponsorContract,
        stackspotsContract: ctx.contract,
        refresh,
        ctx,
      }),
    ),
  );
  // Decoded read-only values, plus the pot principal so the profile can render a card.
  const results = loaded.flatMap((row, index) => {
    const pot = limited[index];
    const print = pot?.values && typeof pot.values === "object" ? pot.values : {};
    if (!row.hasDecoded && pot?.lastEvent !== "pre-init") return [];
    const values = row.hasDecoded ? row.values : print;
    return [{
      ...values,
      "pot-contract": pot?.potAddress ?? values["pot-contract"] ?? null,
      "pot-type": pot?.potType ?? values["pot-type"] ?? null,
      "pot-owner": pot?.potOwner ?? values["pot-owner"] ?? null,
      "pot-name": values["pot-name"] ?? pot?.potName ?? null,
    }];
  });

  return {
    owner: owner ?? null,
    contract: contract ?? null,
    sponsorContract: sponsorContract ?? null,
    sponsor: sponsor ?? null,
    pots: results,
    total: results.length,
    limit: POT_DETAILS_MAX,
    truncated: matched.length > POT_DETAILS_MAX,
  };
}
