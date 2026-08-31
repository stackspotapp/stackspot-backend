import { config } from "./config.js";
import { decodePrintHex } from "./decoder.js";
import { fetchNewLogs } from "./hiro.js";
import { areEventIdsKnown, listEventIds, listPots, saveEvents, setSyncState } from "./cache.js";
import { isPotContractId } from "./pots.js";

export function toCachedEvent(log) {
  const decoded = decodePrintHex(log.hex);
  return {
    id: `${log.txId}:${log.eventIndex}`,
    txId: log.txId,
    eventIndex: log.eventIndex,
    eventType: log.eventType,
    topic: log.topic,
    contractId: log.contractId,
    blockHeight: log.blockHeight,
    burnBlockHeight: log.burnBlockHeight,
    hex: log.hex,
    repr: log.repr,
    event: decoded.event,
    values: decoded.values,
    clarity: decoded.clarity,
    decodeError: decoded.decodeError ?? null,
  };
}

async function syncContract(contractId, ctx, { full, maxPages } = {}) {
  const { logs, mode } = await fetchNewLogs({
    contractId,
    fallbackContractId: ctx.contract,
    isKnown: full ? null : (ids) => areEventIdsKnown(ids, ctx),
    maxPages: maxPages ?? config.maxSyncPages,
  });
  const stored = await saveEvents(logs.map(toCachedEvent), ctx);
  return { fetched: logs.length, stored, mode };
}

export async function runSync({ full = false, network, contract } = {}) {
  const ctx = {
    network: network ?? config.defaultNetwork,
    contract: contract ?? config.contracts[network ?? config.defaultNetwork],
  };
  if (!ctx.contract) {
    const error = new Error(
      `No Stackspots contract configured for ${ctx.network}. Set STACKSPOTS_CONTRACT_${ctx.network.toUpperCase()}.`,
    );
    error.status = 400;
    throw error;
  }

  let fetched = 0;
  let stored = 0;
  let mode = null;

  const stackspots = await syncContract(ctx.contract, ctx, { full });
  fetched += stackspots.fetched;
  stored += stackspots.stored;
  mode = stackspots.mode;

  const pots = await listPots(ctx);
  for (const pot of pots) {
    const contractId = pot.potAddress;
    if (!isPotContractId(contractId) || contractId === ctx.contract) continue;
    try {
      const extra = await syncContract(contractId, ctx, { full });
      fetched += extra.fetched;
      stored += extra.stored;
      if (extra.mode) mode = extra.mode;
    } catch (error) {
      console.error(`[sync] ${ctx.network} ${contractId}`, error.message);
    }
  }

  const { total } = await listEventIds({ ...ctx, limit: 1 });
  await setSyncState(
    {
      lastSyncAt: Date.now(),
      lastCount: stored,
      totalCached: total,
      mode,
      error: "",
    },
    ctx,
  );
  return { network: ctx.network, contract: ctx.contract, fetched, stored, total, mode };
}

export async function runSyncSafe(options) {
  const network = options?.network ?? config.defaultNetwork;
  const contract = options?.contract ?? config.contracts[network];
  const ctx = { network, contract };
  try {
    return await runSync(options);
  } catch (error) {
    console.error("[sync]", error.message);
    try {
      await setSyncState(
        {
          lastSyncAt: Date.now(),
          lastCount: 0,
          error: error.message,
        },
        ctx,
      );
    } catch (cacheError) {
      console.error("[sync] failed to record error", cacheError.message);
    }
    throw error;
  }
}

export async function runSyncAll({ full = false } = {}) {
  const results = [];
  for (const network of ["mainnet", "testnet"]) {
    if (!config.contracts[network]) continue;
    results.push(await runSyncSafe({ full, network, contract: config.contracts[network] }));
  }
  return results;
}
