import { createClient } from "redis";
import { eventDedupeId, eventPrint, toPublicEvent } from "./catalog.js";
import { config } from "./config.js";
import { fetchTransaction } from "./hiro.js";
import { apiUrlForNetwork } from "./network.js";
import {
  applyEventToPot,
  mergePotRecord,
  normalizeListedPot,
  potEventKey,
  POT_STATUSES,
  resolvePotAddress,
} from "./pots.js";
import {
  applyEventToSponsor,
  mergeSponsorRecord,
  normalizeListedSponsor,
  resolveSponsorContract,
  sponsorIndexKeys,
} from "./sponsors.js";

function keysFor(network) {
  const ns = `stackspots:${network ?? config.defaultNetwork}`;
  return {
    events: `${ns}:events`,
    event: (id) => `${ns}:event:${id}`,
    byEvent: (name) => `${ns}:by-event:${name}`,
    byPot: (pot) => `${ns}:by-pot:${pot}`,
    pots: `${ns}:pots`,
    sponsors: `${ns}:sponsors`,
    bySponsor: (id) => `${ns}:by-sponsor:${id}`,
    sync: `${ns}:sync`,
    ids: `${ns}:ids`,
    alias: (id) => `${ns}:alias:${id}`,
    potLive: (id) => `${ns}:pot-live:${String(id).trim().toLowerCase()}`,
    contract: (id) => `${ns}:contract:${id}`,
    stats: `${ns}:stats:snapshot`,
  };
}

function scope(ctx = {}) {
  const network = ctx.network ?? config.defaultNetwork;
  const contract = ctx.contract ?? config.contracts[network] ?? config.stackspotsContract;
  return { network, contract, keys: keysFor(network) };
}

let client;

export async function connectRedis() {
  if (client?.isOpen) return client;
  const url = config.redisUrl;
  const useTls = url.startsWith("rediss://");
  client = createClient({
    url,
    socket: useTls
      ? {
          tls: true,
          rejectUnauthorized: process.env.REDIS_TLS_INSECURE !== "1",
        }
      : undefined,
  });
  client.on("error", (err) => {
    console.error("[redis]", err.message);
  });
  await client.connect();
  return client;
}

export function getRedis() {
  if (!client?.isOpen) {
    throw new Error("Redis is not connected");
  }
  return client;
}

function eventScore(event) {
  const height = Number(event.blockHeight ?? event.burnBlockHeight ?? 0);
  const index = Number(event.eventIndex ?? 0);
  if (height > 0) return height * 1_000_000 + index;
  const sortScore = Number(event.sortScore ?? 0);
  if (sortScore > 0) return sortScore;
  return index;
}

/** Latest → oldest for API responses. */
export function compareEventsLatestFirst(a, b) {
  const scoreDiff = eventScore(b) - eventScore(a);
  if (scoreDiff !== 0) return scoreDiff;
  const tx = String(b.txId ?? "").localeCompare(String(a.txId ?? ""));
  if (tx !== 0) return tx;
  return Number(b.eventIndex ?? 0) - Number(a.eventIndex ?? 0);
}

export function comparePotsLatestFirst(a, b) {
  // Prefer real Stacks block height (from Hiro tx), then sync sortScore.
  const as = Number(a.lastBlockHeight ?? 0) || Number(a.sortScore ?? 0);
  const bs = Number(b.lastBlockHeight ?? 0) || Number(b.sortScore ?? 0);
  if (bs !== as) return bs - as;
  const tx = String(b.lastTxId ?? "").localeCompare(String(a.lastTxId ?? ""));
  if (tx !== 0) return tx;
  return String(b.potAddress ?? "").localeCompare(String(a.potAddress ?? ""));
}

function stacksApiFromCtx(ctx = {}) {
  return ctx.stacksApiUrl ?? apiUrlForNetwork(ctx.network ?? config.defaultNetwork);
}

/** Hiro v2 contract logs omit block_height — fill from /extended/v1/tx/:id. */
async function enrichEventsWithTxHeights(events, ctx = {}) {
  const apiUrl = stacksApiFromCtx(ctx);
  const byTx = new Map();
  for (const event of events) {
    const txId = event?.txId;
    if (!txId) continue;
    if (Number(event.blockHeight ?? event.burnBlockHeight ?? 0) > 0) continue;
    if (!byTx.has(txId)) byTx.set(txId, []);
    byTx.get(txId).push(event);
  }
  if (!byTx.size) return events;

  await Promise.all(
    [...byTx.entries()].map(async ([txId, rows]) => {
      try {
        const tx = await fetchTransaction(txId, apiUrl);
        const blockHeight = Number(tx?.block_height ?? 0) || null;
        const burnBlockHeight = Number(tx?.burn_block_height ?? 0) || null;
        if (!blockHeight && !burnBlockHeight) return;
        for (const event of rows) {
          if (blockHeight) event.blockHeight = blockHeight;
          if (burnBlockHeight) event.burnBlockHeight = burnBlockHeight;
          const height = blockHeight || burnBlockHeight;
          event.sortScore = height * 1_000_000 + Number(event.eventIndex ?? 0);
        }
      } catch (error) {
        console.error("[cache] tx height", txId, error.message);
      }
    }),
  );
  return events;
}

async function enrichPotsWithTxHeights(pots, ctx = {}) {
  const apiUrl = stacksApiFromCtx(ctx);
  const redis = getRedis();
  const { keys } = scope(ctx);
  const missing = pots.filter(
    (pot) => pot?.lastTxId && !(Number(pot.lastBlockHeight ?? 0) > 0),
  );
  if (!missing.length) return pots;

  await Promise.all(
    missing.map(async (pot) => {
      try {
        const tx = await fetchTransaction(pot.lastTxId, apiUrl);
        const blockHeight = Number(tx?.block_height ?? 0) || null;
        const burnBlockHeight = Number(tx?.burn_block_height ?? 0) || null;
        if (!blockHeight && !burnBlockHeight) return;
        pot.lastBlockHeight = blockHeight || burnBlockHeight;
        pot.sortScore = Number(pot.lastBlockHeight) * 1_000_000;
        if (burnBlockHeight && pot.values && typeof pot.values === "object") {
          pot.values = { ...pot.values, "burn-block-height": String(burnBlockHeight) };
        }
        await redis.hSet(keys.pots, pot.potAddress, JSON.stringify(pot));
      } catch (error) {
        console.error("[cache] pot tx height", pot.potAddress, error.message);
      }
    }),
  );
  return pots;
}

function potIndexKeys(event, stackspotsContract) {
  const values = eventPrint(event);
  const keys = new Set();
  const address = resolvePotAddress(event, stackspotsContract);
  if (address) keys.add(String(address));
  if (values && typeof values === "object") {
    if (values["pot-id"] != null) keys.add(String(values["pot-id"]));
    if (values["token-id"] != null) keys.add(String(values["token-id"]));
  }
  if (event?.contractId && event.contractId !== stackspotsContract) {
    keys.add(event.contractId);
  }
  return [...keys];
}

function txIdKey(txId) {
  return String(txId ?? "").replace(/^0x/i, "").toLowerCase();
}

/** Drop every remembered id so the next sync re-decodes print hex. */
export async function forgetAllEventIds(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const count = await redis.sCard(keys.ids);
  if (count) await redis.del(keys.ids);
  return count;
}

const FULL_PRINT_SCHEMA = "full-hex-decode";

export async function needsFullPrintRefetch(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  return (await redis.hGet(keys.sync, "printSchema")) !== FULL_PRINT_SCHEMA;
}

export async function markFullPrintSchema(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  await redis.hSet(keys.sync, "printSchema", FULL_PRINT_SCHEMA);
}

/** Drop remembered ids for a tx so the next sync re-reads its print hex. */
export async function forgetEventIdsForTx(txId, ctx = {}) {
  const needle = txIdKey(txId);
  if (!needle) return 0;
  const redis = getRedis();
  const { keys } = scope(ctx);
  const ids = await redis.sMembers(keys.ids);
  const drop = ids.filter((id) => txIdKey(String(id).split(":")[0]) === needle);
  if (drop.length) await redis.sRem(keys.ids, drop);
  return drop.length;
}

/** Write sponsors onto the already-cached init-pot row so a new dedupe id is not required. */
export async function setStoredInitPotSponsors(txid, contract, sponsors, ctx = {}) {
  if (!Array.isArray(sponsors)) return 0;
  const redis = getRedis();
  const { keys } = scope(ctx);
  const ids = await redis.zRange(keys.byEvent("init-pot"), 0, -1);
  if (!ids.length) return 0;
  const raws = await redis.mGet(ids.map((id) => keys.event(id)));
  const wantTx = txIdKey(txid);
  const wantPot = String(contract ?? "").trim().toLowerCase();
  let updated = 0;
  for (let index = 0; index < ids.length; index += 1) {
    if (!raws[index]) continue;
    let event;
    try {
      event = JSON.parse(raws[index]);
    } catch {
      continue;
    }
    const eventTx = txIdKey(event.txid);
    const eventPot = String(event.contract ?? event["pot-treasury"] ?? "").trim().toLowerCase();
    if (wantTx && eventTx !== wantTx) continue;
    if (wantPot && eventPot !== wantPot) continue;
    if (Array.isArray(event.sponsors) && event.sponsors.length) continue;
    event.sponsors = sponsors;
    await redis.set(keys.event(ids[index]), JSON.stringify(event));
    updated += 1;
  }
  return updated;
}

export async function rememberEventIds(ids, ctx = {}) {
  if (!ids.length) return;
  const redis = getRedis();
  const { keys } = scope(ctx);
  await redis.sAdd(keys.ids, ids);
}

/**
 * Skipped prints are remembered by id only. If that id has no stored event,
 * a later catalog match (such as sponsor-platform) would never be fetched again.
 */
export async function releaseUnstoredEventIds(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const ids = await redis.sMembers(keys.ids);
  if (!ids.length) return 0;
  const stored = await redis.mGet(ids.map((id) => keys.event(id)));
  const aliases = await redis.mGet(ids.map((id) => keys.alias(id)));
  const missing = [];
  for (let index = 0; index < ids.length; index += 1) {
    if (stored[index]) continue;
    const canonical = aliases[index];
    if (canonical && (await redis.exists(keys.event(canonical)))) continue;
    if (canonical) await redis.del(keys.alias(ids[index]));
    missing.push(ids[index]);
  }
  if (missing.length) await redis.sRem(keys.ids, missing);
  return missing.length;
}

/** A fuller re-decode changes the print hash. Drop the older row for the same tx and event. */
async function dropStalePrintSiblings(redis, keys, id, payload, contract) {
  const txid = txIdKey(payload?.txid);
  const name = payload?.event;
  if (!txid || !name) return;
  const ids = await redis.zRange(keys.byEvent(name), 0, -1);
  for (const other of ids) {
    if (other === id) continue;
    if (txIdKey(String(other).split(":")[0]) !== txid) continue;
    let stored = null;
    try {
      const raw = await redis.get(keys.event(other));
      stored = raw ? JSON.parse(raw) : null;
    } catch {
      stored = null;
    }
    await unindexEvent(redis, keys, other, stored ?? payload, contract);
  }
}

function storedEventId(event) {
  return event?.id ?? `${event?.txId ?? event?.txid}:${event?.eventIndex ?? 0}`;
}

function sameStoredPayload(stored, payload) {
  const left = Object.keys(stored ?? {}).sort();
  const right = Object.keys(payload ?? {}).sort();
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index] && JSON.stringify(stored[key]) === JSON.stringify(payload[key]));
}

export async function compactStoredEvents(ctx = {}) {
  const redis = getRedis();
  const { keys, network } = scope(ctx);
  const ids = await redis.zRange(keys.events, 0, -1);
  if (!ids.length) return { network, kept: 0, dropped: 0 };

  const raw = await redis.mGet(ids.map((id) => keys.event(id)));
  let kept = 0;
  let dropped = 0;

  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    let event = null;
    try {
      event = raw[i] ? JSON.parse(raw[i]) : null;
    } catch {
      event = null;
    }
    const stored = toPublicEvent(event);
    const next = stored
      ? { ...stored, ...(event?.sourceContract ? { sourceContract: event.sourceContract } : {}) }
      : null;
    if (!next) {
      const name = event?.event ?? eventPrint(event).event;
      const multi = redis.multi();
      multi.del(keys.event(id));
      multi.zRem(keys.events, id);
      if (name) multi.zRem(keys.byEvent(name), id);
      multi.sRem(keys.ids, id);
      await multi.exec();
      dropped += 1;
      continue;
    }
    if (sameStoredPayload(event, next)) {
      kept += 1;
      continue;
    }
    await redis.set(keys.event(id), JSON.stringify(next));
    kept += 1;
  }

  const duplicates = await dropDuplicateTxPrints(ctx);
  dropped += duplicates;

  if (dropped) await invalidateStats(ctx);
  if (kept || dropped) {
    console.log(`[cache] ${network} compacted events kept ${kept} dropped ${dropped}`);
  }
  return { network, kept, dropped };
}

async function unindexEvent(redis, keys, id, payload, stackspotsContract) {
  const multi = redis.multi();
  multi.del(keys.event(id));
  multi.zRem(keys.events, id);
  multi.sRem(keys.ids, id);
  if (payload?.event) multi.zRem(keys.byEvent(payload.event), id);
  const asEvent = payload ? { ...payload, id } : { id };
  for (const pot of potIndexKeys(asEvent, stackspotsContract)) {
    multi.zRem(keys.byPot(pot), id);
  }
  for (const sponsor of sponsorIndexKeys(asEvent, stackspotsContract)) {
    multi.zRem(keys.bySponsor(sponsor), id);
  }
  await multi.exec();
}

/** Identical prints in one tx (sponsor contract + stackspots forward) share one row. */
async function dropDuplicateTxPrints(ctx) {
  const redis = getRedis();
  const { keys, contract } = scope(ctx);
  const ids = await redis.zRange(keys.events, 0, -1);
  if (!ids.length) return 0;

  const raw = await redis.mGet(ids.map((id) => keys.event(id)));
  const groups = new Map();
  for (let index = 0; index < ids.length; index += 1) {
    let event = null;
    try {
      event = raw[index] ? JSON.parse(raw[index]) : null;
    } catch {
      event = null;
    }
    const payload = toPublicEvent(event);
    const dedupeId = eventDedupeId(payload);
    if (!payload || !dedupeId) continue;
    if (!groups.has(dedupeId)) groups.set(dedupeId, []);
    groups.get(dedupeId).push({ id: ids[index], payload });
  }

  let dropped = 0;
  for (const [dedupeId, members] of groups) {
    if (members.length === 1 && members[0].id === dedupeId) continue;
    const keeper = members.find((member) => member.id === dedupeId) ?? members[0];
    const score = Number(await redis.zScore(keys.events, keeper.id)) || 0;
    if (keeper.id !== dedupeId) {
      await redis.set(keys.event(dedupeId), JSON.stringify(keeper.payload));
      const multi = redis.multi();
      multi.zAdd(keys.events, { score, value: dedupeId });
      multi.sAdd(keys.ids, dedupeId);
      if (keeper.payload.event) {
        multi.zAdd(keys.byEvent(keeper.payload.event), { score, value: dedupeId });
      }
      for (const pot of potIndexKeys(keeper.payload, contract)) {
        multi.zAdd(keys.byPot(pot), { score, value: dedupeId });
      }
      for (const sponsor of sponsorIndexKeys(keeper.payload, contract)) {
        multi.zAdd(keys.bySponsor(sponsor), { score, value: dedupeId });
      }
      await multi.exec();
    }
    for (const member of members) {
      if (member.id === dedupeId) continue;
      await unindexEvent(redis, keys, member.id, member.payload, contract);
      await redis.set(keys.alias(member.id), dedupeId);
      await redis.sAdd(keys.ids, member.id);
      dropped += 1;
    }
  }
  return dropped;
}

export async function saveEvents(events, ctx = {}) {
  const redis = getRedis();
  if (!events.length) return 0;
  const { keys, contract } = scope(ctx);
  await enrichEventsWithTxHeights(events, ctx);

  const ttl = config.cacheTtlSeconds > 0 ? config.cacheTtlSeconds : null;
  let stored = 0;
  const written = new Set();

  for (const event of events) {
    const payload = toPublicEvent(event);
    if (!payload) continue;
    if (event?.contractId) payload.sourceContract = event.contractId;
    const sourceId = storedEventId(event);
    const id = eventDedupeId(payload) ?? sourceId;
    if (written.has(id)) {
      if (sourceId !== id) {
        await redis.sAdd(keys.ids, sourceId);
        await redis.set(keys.alias(sourceId), id);
      }
      continue;
    }
    const existingRaw = await redis.get(keys.event(id));
    if (existingRaw) {
      try {
        if (sameStoredPayload(JSON.parse(existingRaw), payload)) {
          written.add(id);
          if (sourceId !== id) {
            await redis.sAdd(keys.ids, sourceId);
            await redis.set(keys.alias(sourceId), id);
          }
          continue;
        }
      } catch {
        // replace a corrupt row
      }
    }
    const score = eventScore(event);
    const multi = redis.multi();
    multi.set(keys.event(id), JSON.stringify(payload));
    if (ttl) multi.expire(keys.event(id), ttl);
    multi.zAdd(keys.events, { score, value: id });
    multi.sAdd(keys.ids, id);
    if (sourceId !== id) {
      multi.sAdd(keys.ids, sourceId);
      multi.set(keys.alias(sourceId), id);
    }
    if (payload.event) {
      multi.zAdd(keys.byEvent(payload.event), { score, value: id });
    }
    for (const pot of potIndexKeys(event, contract)) {
      multi.zAdd(keys.byPot(pot), { score, value: id });
    }
    for (const sponsor of sponsorIndexKeys(event, contract)) {
      multi.zAdd(keys.bySponsor(sponsor), { score, value: id });
    }
    await multi.exec();
    await dropStalePrintSiblings(redis, keys, id, payload, contract);
    written.add(id);
    stored += 1;
  }

  const incomingByPot = new Map();
  for (const event of events) {
    const address = resolvePotAddress(event, contract);
    if (!address) continue;
    const next = applyEventToPot(incomingByPot.get(address), event, contract);
    if (next) incomingByPot.set(address, next);
  }
  for (const [address, incoming] of incomingByPot) {
    const existingRaw = await redis.hGet(keys.pots, address);
    let existing = null;
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw);
      } catch {
        existing = null;
      }
    }
    const merged = mergePotRecord(existing, incoming);
    if (merged) await redis.hSet(keys.pots, address, JSON.stringify(merged));
  }

  const incomingBySponsor = new Map();
  for (const event of events) {
    const address = resolveSponsorContract(event, contract);
    if (!address) continue;
    const next = applyEventToSponsor(incomingBySponsor.get(address), event, contract);
    if (next) incomingBySponsor.set(address, next);
  }
  for (const [address, incoming] of incomingBySponsor) {
    const existingRaw = await redis.hGet(keys.sponsors, address);
    let existing = null;
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw);
      } catch {
        existing = null;
      }
    }
    const merged = mergeSponsorRecord(existing, incoming);
    if (merged) await redis.hSet(keys.sponsors, address, JSON.stringify(merged));
  }

  if (stored) await invalidateStats(ctx);
  return stored;
}

export async function areEventIdsKnown(ids, ctx = {}) {
  const redis = getRedis();
  if (!ids.length) return [];
  const { keys } = scope(ctx);
  const flags = await redis.smIsMember(keys.ids, ids);
  return flags.map((flag) => Boolean(flag));
}

export async function listEventIds({ eventName, pot, sponsor, offset = 0, limit = 50, ...ctx } = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const key = eventName
    ? keys.byEvent(eventName)
    : sponsor != null && sponsor !== ""
      ? keys.bySponsor(String(sponsor))
      : pot != null && pot !== ""
        ? keys.byPot(String(pot))
        : keys.events;

  const start = Math.max(0, offset);
  const stop = start + Math.max(1, limit) - 1;
  const [ids, total] = await Promise.all([
    redis.zRange(key, start, stop, { REV: true }),
    redis.zCard(key),
  ]);
  return { ids, total };
}

export async function getEventsByIds(ids, ctx = {}) {
  const redis = getRedis();
  if (!ids.length) return [];
  const { keys } = scope(ctx);
  const values = await redis.mGet(ids.map((id) => keys.event(id)));
  const byId = new Map();
  ids.forEach((id, index) => {
    const raw = values[index];
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const event = toPublicEvent(parsed);
      if (event) {
        if (parsed?.sourceContract) event.sourceContract = parsed.sourceContract;
        byId.set(id, event);
      }
    } catch {
      // skip bad rows
    }
  });
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function listPots({ status, event, ...ctx } = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const byAddress = new Map();
  for (const raw of Object.values(await redis.hGetAll(keys.pots))) {
    let pot = null;
    try {
      pot = normalizeListedPot(JSON.parse(raw));
    } catch {
      pot = null;
    }
    if (!pot?.potAddress) continue;
    const key = String(pot.potAddress).trim().toLowerCase();
    const prev = byAddress.get(key);
    if (!prev || comparePotsLatestFirst(pot, prev) < 0) {
      byAddress.set(key, pot);
    }
  }
  let pots = [...byAddress.values()];

  await enrichPotsWithTxHeights(pots, ctx);
  pots.sort(comparePotsLatestFirst);

  if (event) {
    const wanted = String(event).trim();
    pots = pots.filter((pot) => potEventKey(pot) === wanted);
  } else if (status && POT_STATUSES.includes(status)) {
    pots = pots.filter((pot) => pot.status === status);
  }
  return pots;
}

export async function setSyncState(state, ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const fields = {};
  if (state.lastSyncAt != null) fields.lastSyncAt = String(state.lastSyncAt);
  if (state.lastCount != null) fields.lastCount = String(state.lastCount);
  if (state.totalCached != null) fields.totalCached = String(state.totalCached);
  if (state.mode != null) fields.mode = String(state.mode);
  if (state.error != null) fields.error = String(state.error);
  if (Object.keys(fields).length) await redis.hSet(keys.sync, fields);
}

export async function getSyncState(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const raw = await redis.hGetAll(keys.sync);
  return {
    lastSyncAt: raw.lastSyncAt ? Number(raw.lastSyncAt) : null,
    lastCount: raw.lastCount ? Number(raw.lastCount) : 0,
    totalCached: raw.totalCached ? Number(raw.totalCached) : 0,
    mode: raw.mode || null,
    error: raw.error || null,
  };
}

/** Replay stored prints into the sponsor hash so a cached sponsor-platform log is listable. */
export async function rebuildSponsorsFromEvents(ctx = {}) {
  const events = await listAllEvents(ctx);
  const redis = getRedis();
  const { keys, contract } = scope(ctx);
  const existing = new Map();
  for (const [address, raw] of Object.entries(await redis.hGetAll(keys.sponsors))) {
    try {
      const row = JSON.parse(raw);
      if (row?.sponsorContract) existing.set(address, row);
    } catch {
      // skip bad rows
    }
  }
  const bySponsor = new Map();
  for (const event of events) {
    const address = resolveSponsorContract(event, contract);
    if (!address) continue;
    const next = applyEventToSponsor(bySponsor.get(address) ?? existing.get(address), event, contract);
    if (next) bySponsor.set(address, next);
  }
  for (const [address, row] of existing) {
    if (!bySponsor.has(address)) bySponsor.set(address, row);
    else bySponsor.set(address, mergeSponsorRecord(row, bySponsor.get(address)));
  }
  await redis.del(keys.sponsors);
  if (bySponsor.size) {
    const entries = {};
    for (const [address, row] of bySponsor) entries[address] = JSON.stringify(row);
    await redis.hSet(keys.sponsors, entries);
  }
  return bySponsor.size;
}

export async function listSponsors(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const sponsors = Object.values(await redis.hGetAll(keys.sponsors))
    .map((raw) => {
      try {
        return normalizeListedSponsor(JSON.parse(raw));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  sponsors.sort(comparePotsLatestFirst);
  return sponsors;
}

export async function listAllEvents(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const ids = await redis.zRange(keys.events, 0, -1, { REV: true });
  return getEventsByIds(ids, ctx);
}

export async function getSponsor(key, ctx = {}) {
  if (key == null || key === "") return null;
  const redis = getRedis();
  const { keys } = scope(ctx);
  const needle = String(key);
  const direct = await redis.hGet(keys.sponsors, needle);
  if (direct) {
    try {
      return normalizeListedSponsor(JSON.parse(direct));
    } catch {
      return null;
    }
  }
  const sponsors = await listSponsors(ctx);
  const lower = needle.toLowerCase();
  return (
    sponsors.find(
      (row) =>
        row.sponsorContract === needle ||
        row.sponsor === needle ||
        String(row.sponsorContract ?? "").toLowerCase() === lower ||
        String(row.sponsor ?? "").toLowerCase() === lower,
    ) ?? null
  );
}

export async function getPot(key, ctx = {}) {
  if (key == null || key === "") return null;
  const redis = getRedis();
  const { keys } = scope(ctx);
  const direct = await redis.hGet(keys.pots, String(key));
  if (direct) {
    try {
      return JSON.parse(direct);
    } catch {
      return null;
    }
  }
  const pots = await listPots(ctx);
  return pots.find((pot) => pot.potAddress === key) ?? null;
}

export async function getPotEventCount(key, ctx = {}) {
  if (key == null || key === "") return 0;
  const { keys } = scope(ctx);
  return getRedis().zCard(keys.byPot(String(key)));
}

export async function setPotLive(contractId, values, ctx = {}) {
  const id = String(contractId ?? "").trim();
  if (!id || !values || typeof values !== "object") return null;
  const redis = getRedis();
  const { keys } = scope(ctx);
  const updatedAt = Date.now();
  const snapshot = { contract: id, updatedAt, values };
  await redis.set(keys.potLive(id), JSON.stringify(snapshot));

  const pots = await redis.hGetAll(keys.pots);
  const want = id.toLowerCase();
  for (const [hashKey, raw] of Object.entries(pots)) {
    let pot = null;
    try {
      pot = raw ? JSON.parse(raw) : null;
    } catch {
      pot = null;
    }
    if (!pot || typeof pot !== "object") continue;
    const address = String(pot.potAddress ?? hashKey).trim().toLowerCase();
    if (address !== want && String(hashKey).trim().toLowerCase() !== want) continue;
    pot.live = values;
    pot.liveUpdatedAt = updatedAt;
    await redis.hSet(keys.pots, hashKey, JSON.stringify(pot));
  }
  return snapshot;
}

export async function getPotLive(contractId, ctx = {}) {
  const id = String(contractId ?? "").trim();
  if (!id) return null;
  const raw = await getRedis().get(scope(ctx).keys.potLive(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getPotLives(contractIds, ctx = {}) {
  const ids = [...new Set((contractIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const { keys } = scope(ctx);
  const raws = await getRedis().mGet(ids.map((id) => keys.potLive(id)));
  const out = new Map();
  ids.forEach((id, index) => {
    if (!raws[index]) return;
    try {
      const parsed = JSON.parse(raws[index]);
      if (parsed?.values) out.set(id.toLowerCase(), parsed.values);
    } catch {
      // skip a corrupt live snapshot
    }
  });
  return out;
}

export async function getCachedContract(contractId, ctx = {}) {
  const { keys } = scope(ctx);
  const raw = await getRedis().get(keys.contract(contractId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedContract(contractId, data, ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const payload = JSON.stringify(data);
  const ttl = config.contractCacheTtlSeconds;
  if (ttl > 0) {
    await redis.set(keys.contract(contractId), payload, { EX: ttl });
  } else {
    await redis.set(keys.contract(contractId), payload);
  }
}

export async function getCachedStats(ctx = {}) {
  const { keys } = scope(ctx);
  const raw = await getRedis().get(keys.stats);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedStats(data, ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const payload = JSON.stringify(data);
  const ttl = config.contractCacheTtlSeconds;
  if (ttl > 0) {
    await redis.set(keys.stats, payload, { EX: ttl });
  } else {
    await redis.set(keys.stats, payload);
  }
}

export async function invalidateStats(ctx = {}) {
  try {
    const { keys } = scope(ctx);
    await getRedis().del(keys.stats);
  } catch {
    // Redis may not be connected during tests
  }
}
