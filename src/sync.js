import { config } from "./config.js";
import { isStackspotsLogType } from "./catalog.js";
import { decodePrintHex, expandEncodedValues } from "./decoder.js";
import { fetchAddressDeployedContracts, fetchNewLogs } from "./hiro.js";
import { apiUrlForNetwork } from "./network.js";
import {
  areEventIdsKnown,
  forgetAllEventIds,
  listEventIds,
  markFullPrintSchema,
  needsFullPrintRefetch,
  rebuildSponsorsFromEvents,
  releaseUnstoredEventIds,
  rememberEventIds,
  saveEvents,
  setSyncState,
} from "./cache.js";
import { isLikelyPotContract, isPotContractId } from "./pots.js";

/** In-memory sync row. Redis stores only the extracted print fields plus txid. */
export function toCachedEvent(log) {
  const id = `${log.txId}:${log.eventIndex}`;
  const decoded = decodePrintHex(log.hex);
  if (!isStackspotsLogType(decoded.event) || !decoded.values || typeof decoded.values !== "object") {
    return { id, skip: true };
  }

  const values = expandEncodedValues({ ...decoded.values, event: decoded.event });
  const burnFromValues = Number(values?.["burn-block-height"] ?? 0);
  const stacksFromValues = Number(values?.["stacks-block-height"] ?? 0);
  const blockHeight =
    log.blockHeight ??
    (Number.isFinite(stacksFromValues) && stacksFromValues > 0 ? stacksFromValues : null);
  const burnBlockHeight =
    log.burnBlockHeight ??
    (Number.isFinite(burnFromValues) && burnFromValues > 0 ? burnFromValues : null);

  return {
    id,
    txId: log.txId,
    eventIndex: log.eventIndex ?? 0,
    event: decoded.event,
    contractId: log.contractId ?? null,
    blockHeight,
    burnBlockHeight,
    values,
  };
}

async function syncContract(contractId, ctx, { full, maxPages } = {}) {
  const { logs, mode, truncated } = await fetchNewLogs({
    contractId,
    fallbackContractId: ctx.contract,
    isKnown: full ? null : (ids) => areEventIdsKnown(ids, ctx),
    maxPages: maxPages ?? config.maxSyncPages,
  });
  const mapped = logs.map(toCachedEvent);
  const core = String(ctx.contract ?? "").trim().toLowerCase();
  const kept = mapped.filter((event) => {
    if (!event || event.skip) return false;
    const source = String(event.contractId ?? "").trim().toLowerCase();
    return !core || !source || source === core;
  });
  const skipped = mapped.filter((event) => event?.skip).map((event) => event.id);
  const stored = await saveEvents(kept, ctx);
  if (skipped.length) await rememberEventIds(skipped, ctx);
  return { fetched: logs.length, stored, mode, truncated: Boolean(truncated) };
}

export async function syncContracts(contractIds, ctx, { full, maxPages, synced } = {}) {
  const seen = synced ?? new Set();
  let fetched = 0;
  let stored = 0;
  let mode = null;
  for (const contractId of contractIds) {
    if (!isPotContractId(contractId) || seen.has(contractId)) continue;
    try {
      const extra = await syncContract(contractId, ctx, { full, maxPages });
      fetched += extra.fetched;
      stored += extra.stored;
      if (extra.mode) mode = extra.mode;
      seen.add(contractId);
    } catch (error) {
      console.error(`[sync] ${ctx.network} ${contractId}`, error.message);
    }
  }
  return { fetched, stored, mode, synced: seen };
}

export async function syncOwnerDeployedPots(owner, ctx, options = {}) {
  const principal = String(owner ?? "").trim().split(".")[0];
  if (!principal) {
    return { fetched: 0, stored: 0, mode: null, synced: options.synced ?? new Set(), contracts: [] };
  }
  const apiUrl = ctx.stacksApiUrl ?? apiUrlForNetwork(ctx.network);
  const contracts = (
    await fetchAddressDeployedContracts(principal, {
      apiUrl,
      maxPages: options.maxPages ?? 8,
    })
  ).filter(isLikelyPotContract);
  // Profile /pots/details only needs contract ids; full log sync can finish in the background.
  if (options.discoverOnly) {
    return { fetched: 0, stored: 0, mode: null, synced: options.synced ?? new Set(), contracts };
  }
  const result = await syncContracts(contracts, ctx, options);
  return { ...result, contracts };
}

const releasedNetworks = new Set();

export async function runSync({ full = false, network, contract } = {}) {
  const ctx = {
    network: network ?? config.defaultNetwork,
    contract: contract ?? config.contracts[network ?? config.defaultNetwork],
    stacksApiUrl: apiUrlForNetwork(network ?? config.defaultNetwork),
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

  if (!releasedNetworks.has(ctx.network)) {
    if (await needsFullPrintRefetch(ctx)) {
      const released = await forgetAllEventIds(ctx);
      console.log(`[sync] ${ctx.network} refetching prints so cached rows keep the full hex decode (${released} ids)`);
    }
    const released = await releaseUnstoredEventIds(ctx);
    releasedNetworks.add(ctx.network);
    if (released) {
      console.log(`[sync] ${ctx.network} released ${released} unstored event ids for refetch`);
    }
  }

  console.log(`[sync] ${ctx.network} fetching ${ctx.contract}`);
  const stackspots = await syncContract(ctx.contract, ctx, { full });
  fetched += stackspots.fetched;
  stored += stackspots.stored;
  mode = stackspots.mode;
  console.log(`[sync] ${ctx.network} platform stored ${stackspots.stored}/${stackspots.fetched}`);

  await rebuildSponsorsFromEvents(ctx);
  if (!stackspots.truncated) await markFullPrintSchema(ctx);

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
  const jobs = ["mainnet", "testnet"]
    .filter((network) => config.contracts[network])
    .map((network) => runSyncSafe({ full, network, contract: config.contracts[network] }));
  return Promise.all(jobs);
}
