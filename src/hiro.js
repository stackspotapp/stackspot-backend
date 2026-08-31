import { config } from "./config.js";
import { apiUrlForPrincipal } from "./network.js";

function encodeContractId(contractId) {
  return encodeURIComponent(contractId);
}

function asNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function eventId(log) {
  return `${log.txId}:${log.eventIndex}`;
}

export function normalizeLog(item, fallbackContractId = config.stackspotsContract) {
  const log = item.contract_log ?? item.log ?? item;
  const value = log.value ?? item.value ?? {};
  const hex = value.hex ?? log.hex ?? item.hex ?? null;
  const block =
    item.block ?? (typeof item.block_height === "object" ? item.block_height : null);

  return {
    txId: item.tx_id ?? item.txId ?? log.tx_id ?? null,
    eventIndex: asNumber(item.event_index ?? item.eventIndex ?? log.event_index, 0),
    eventType: item.event_type ?? item.eventType ?? "smart_contract_log",
    blockHeight: asNumber(
      item.block_height ?? item.blockHeight ?? block?.height ?? log.block_height,
    ),
    burnBlockHeight: asNumber(
      item.burn_block_height ??
        item.burnBlockHeight ??
        item.bitcoin_block?.height ??
        log.burn_block_height,
    ),
    hex: typeof hex === "string" ? hex : null,
    repr: value.repr ?? log.repr ?? null,
    topic: log.topic ?? item.topic ?? "print",
    contractId: log.contract_id ?? item.contract_id ?? fallbackContractId,
  };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const error = new Error(`Hiro ${res.status} ${url}: ${body.slice(0, 240)}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function extractResults(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.logs)) return body.logs;
  if (Array.isArray(body?.events)) return body.events;
  return [];
}

function extractNextCursor(body) {
  if (body?.cursor && typeof body.cursor === "object") {
    return body.cursor.next ?? null;
  }
  return body?.next_cursor ?? (typeof body?.cursor === "string" ? body.cursor : null);
}

/**
 * Prefer v2 contract logs; fall back to deprecated v1 contract events.
 * Hiro returns newest first (offset/cursor 0 is the latest page).
 */
export async function fetchContractLogsPage({
  cursor = null,
  offset = 0,
  limit = config.pageSize,
  contractId = config.stackspotsContract,
} = {}) {
  const apiUrl = apiUrlForPrincipal(contractId, config.defaultNetwork);
  const encoded = encodeContractId(contractId);
  const v2Query = new URLSearchParams({ limit: String(limit) });
  if (cursor) v2Query.set("cursor", String(cursor));
  if (!cursor && offset) v2Query.set("offset", String(offset));

  const v2Url = `${apiUrl}/extended/v2/smart-contracts/${encoded}/logs?${v2Query}`;

  try {
    const body = await fetchJson(v2Url);
    return {
      mode: "v2",
      results: extractResults(body).map((item) => normalizeLog(item, contractId)),
      nextCursor: extractNextCursor(body),
      offset: asNumber(body.offset, offset),
      total: asNumber(body.total),
    };
  } catch (error) {
    if (error.status && ![400, 404, 405].includes(error.status)) {
      throw error;
    }
  }

  const v1Query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const v1Url = `${apiUrl}/extended/v1/contract/${encoded}/events?${v1Query}`;
  const body = await fetchJson(v1Url);
  const results = extractResults(body).map((item) => normalizeLog(item, contractId));
  const total = asNumber(body.total, results.length);
  const nextOffset = offset + results.length;
  return {
    mode: "v1",
    results,
    nextCursor: nextOffset < total && results.length > 0 ? String(nextOffset) : null,
    offset,
    total,
  };
}

export async function fetchNewLogs({
  contractId = config.stackspotsContract,
  fallbackContractId,
  isKnown,
  maxPages = config.maxSyncPages,
} = {}) {
  const collected = [];
  let cursor = null;
  let offset = 0;
  let mode = null;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchContractLogsPage({
      cursor,
      offset,
      limit: config.pageSize,
      contractId: contractId ?? fallbackContractId,
    });
    mode = batch.mode;
    if (!batch.results.length) break;

    const ids = batch.results.map(eventId);
    const known = isKnown ? await isKnown(ids) : ids.map(() => false);

    let unknownOnPage = 0;
    batch.results.forEach((log, i) => {
      if (known[i]) return;
      collected.push(log);
      unknownOnPage += 1;
    });

    if (unknownOnPage === 0) break;
    if (!batch.nextCursor) break;

    if (batch.mode === "v1") {
      offset = Number(batch.nextCursor);
      cursor = null;
    } else {
      cursor = batch.nextCursor;
      offset = 0;
    }
  }

  return { logs: collected, mode };
}

export function parseFunctionName(name) {
  const fn = String(name ?? "").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(fn)) {
    const error = new Error("Invalid Clarity function name");
    error.status = 400;
    throw error;
  }
  return fn;
}

export async function callReadOnly({
  address,
  name,
  functionName,
  sender,
  arguments: argHexes = [],
}) {
  const fn = parseFunctionName(functionName);
  const apiUrl = apiUrlForPrincipal(address, config.defaultNetwork);
  const url = `${apiUrl}/v2/contracts/call-read/${encodeURIComponent(address)}/${encodeURIComponent(name)}/${encodeURIComponent(fn)}`;
  const body = await fetchJson(url, {
    method: "POST",
    body: {
      sender,
      arguments: argHexes,
    },
  });

  if (body.okay === false) {
    const error = new Error(body.cause ?? "Read-only contract call failed");
    error.status = 400;
    error.causeDetail = body;
    throw error;
  }

  return {
    okay: body.okay !== false,
    result: body.result ?? null,
  };
}

export function parseContractId(address, name) {
  const joined = name
    ? `${String(address ?? "").trim()}.${String(name).trim()}`
    : String(address ?? "").trim();
  let decoded = joined;
  try {
    decoded = decodeURIComponent(joined);
  } catch {
    decoded = joined;
  }
  const match = decoded.match(
    /^([S][A-Z0-9]{24,40})\.([a-zA-Z][a-zA-Z0-9_-]{0,127})$/,
  );
  if (!match) {
    const error = new Error(
      "Contract address must be ADDRESS.NAME (e.g. ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.jackpot)",
    );
    error.status = 400;
    throw error;
  }
  return {
    contractId: `${match[1]}.${match[2]}`,
    address: match[1],
    name: match[2],
  };
}
