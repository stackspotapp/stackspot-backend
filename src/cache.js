import { createClient } from "redis";
import { config } from "./config.js";
import {
  applyEventToPot,
  mergePotRecord,
  normalizeListedPot,
  POT_STATUSES,
  resolvePotAddress,
} from "./pots.js";

function keysFor(network) {
  const ns = `stackspots:${network ?? config.defaultNetwork}`;
  return {
    events: `${ns}:events`,
    event: (id) => `${ns}:event:${id}`,
    byEvent: (name) => `${ns}:by-event:${name}`,
    byPot: (pot) => `${ns}:by-pot:${pot}`,
    pots: `${ns}:pots`,
    sync: `${ns}:sync`,
    ids: `${ns}:ids`,
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
      ? { tls: true, rejectUnauthorized: true }
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
  const height = Number(event.blockHeight ?? 0);
  const index = Number(event.eventIndex ?? 0);
  return height * 1_000_000 + index;
}

function potIndexKeys(event, stackspotsContract) {
  const values = event?.values;
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

export async function saveEvents(events, ctx = {}) {
  const redis = getRedis();
  if (!events.length) return 0;
  const { keys, contract } = scope(ctx);

  const ttl = config.cacheTtlSeconds > 0 ? config.cacheTtlSeconds : null;
  let stored = 0;

  for (const event of events) {
    const id = event.id;
    const payload = JSON.stringify(event);
    const score = eventScore(event);
    const multi = redis.multi();
    multi.set(keys.event(id), payload);
    if (ttl) multi.expire(keys.event(id), ttl);
    multi.zAdd(keys.events, { score, value: id });
    multi.sAdd(keys.ids, id);
    if (event.event) {
      multi.zAdd(keys.byEvent(event.event), { score, value: id });
    }
    for (const pot of potIndexKeys(event, contract)) {
      multi.zAdd(keys.byPot(pot), { score, value: id });
    }
    await multi.exec();
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

export async function listEventIds({ eventName, pot, offset = 0, limit = 50, ...ctx } = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const key = eventName
    ? keys.byEvent(eventName)
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
  return values
    .map((raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export async function listPots({ status, ...ctx } = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const all = await redis.hGetAll(keys.pots);
  let pots = Object.values(all)
    .map((raw) => {
      try {
        return normalizeListedPot(JSON.parse(raw));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.lastBlockHeight ?? 0) - Number(a.lastBlockHeight ?? 0));
  if (status && POT_STATUSES.includes(status)) {
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

export async function listAllEvents(ctx = {}) {
  const redis = getRedis();
  const { keys } = scope(ctx);
  const ids = await redis.zRange(keys.events, 0, -1);
  return getEventsByIds(ids, ctx);
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
