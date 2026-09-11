import { getCachedContract, setCachedContract } from "./cache.js";
import { config } from "./config.js";
import { decodeClarityResult } from "./decoder.js";
import { serializeArgs } from "./encode.js";
import { callReadOnly, parseContractId, parseFunctionName } from "./hiro.js";
import { networkFromPrincipal } from "./network.js";
import { isPotContractId } from "./pots.js";
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
    clarity: decoded.clarity,
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
    if (cached) return cached;
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
      clarity: null,
      error: error.message ?? "Read-only contract call failed",
    };
  }
}

async function optionalRead(options) {
  return readCachedFunction(options);
}

function extraValues(map, name) {
  const row = map[name];
  return row?.ok !== false ? row?.values ?? null : null;
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
  const extras = {};

  const details = await readCachedFunction({
    contractId: target,
    functionName: "get-pot-details",
    sender,
    refresh,
    ctx,
  });

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

  for (const functionName of extraNames) {
    extras[functionName] = await optionalRead({
      contractId: target,
      functionName,
      sender,
      refresh,
      ctx,
    });
  }

  if (stackspotsContract) {
    extras["is-contract-allowed-hash"] = await optionalRead({
      contractId: stackspotsContract,
      functionName: "is-contract-allowed-hash",
      sender,
      args: [{ type: "principal", value: target }],
      refresh,
      ctx,
    });
  }

  if (sponsorContract) {
    extras["get-platform-sponsor-ticket"] = await optionalRead({
      contractId: target,
      functionName: "get-platform-sponsor-ticket",
      sender,
      args: [{ type: "principal", value: sponsorContract }],
      refresh,
      ctx,
    });
  }

  const allowedRaw = extraValues(extras, "is-contract-allowed-hash");
  const initRaw = extraValues(extras, "get-pot-is-init");

  return {
    contractId: target,
    owner: sender,
    sponsorContract: sponsorContract ?? null,
    pot: pot ?? null,
    details,
    extras,
    allowed: typeof allowedRaw === "boolean" ? allowedRaw : null,
    initialized: typeof initRaw === "boolean" ? initRaw : null,
    values: details?.values ?? null,
    clarity: details?.clarity ?? null,
    name: extraValues(extras, "get-pot-name"),
    potId: extraValues(extras, "get-pot-id"),
    potCycle: extraValues(extras, "get-pot-cycle"),
    potMinAmount: extraValues(extras, "get-pot-min-amount"),
    potMaxParticipants: extraValues(extras, "get-pot-max-participants"),
    nextPaymentId: extraValues(extras, "get-next-payment-id"),
    sessionEnded: extraValues(extras, "get-pot-session-status"),
    sponsorTicket: extraValues(extras, "get-platform-sponsor-ticket"),
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
  let matched = filterPotsForDetails(pots, {
    owner,
    contract,
    sponsorContract,
    sponsorTickets: sponsor?.tickets ?? [],
  });

  if (contract && matched.length === 0) {
    matched = [{ potAddress: contract, potOwner: owner ?? null, values: {} }];
  }

  const limited = matched.slice(0, POT_DETAILS_MAX);
  const results = [];
  for (const pot of limited) {
    results.push(
      await loadLivePotDetails({
        pot,
        contractId: pot.potAddress,
        owner,
        sponsorContract,
        stackspotsContract: ctx.contract,
        refresh,
        ctx,
      }),
    );
  }

  return {
    owner: owner ?? null,
    contract: contract ?? null,
    sponsorContract: sponsorContract ?? null,
    sponsor: sponsor ?? null,
    pots: results,
    total: matched.length,
    limit: POT_DETAILS_MAX,
    truncated: matched.length > POT_DETAILS_MAX,
  };
}
