import cors from "cors";
import express from "express";
import { pathToFileURL } from "node:url";
import { STACKSPOTS_EVENTS } from "./catalog.js";
import {
  connectRedis,
  getCachedContract,
  getCachedStats,
  getEventsByIds,
  getSyncState,
  listAllEvents,
  listEventIds,
  listPots,
  setCachedContract,
  setCachedStats,
} from "./cache.js";
import { config, requireContract, resolveRequestContext } from "./config.js";
import { decodeClarityResult } from "./decoder.js";
import { serializeArgs } from "./encode.js";
import { callReadOnly, parseContractId, parseFunctionName } from "./hiro.js";
import { networkFromPrincipal } from "./network.js";
import { POT_STATUSES } from "./pots.js";
import { computeStatistics } from "./stats.js";
import { runSyncAll, runSyncSafe } from "./sync.js";

const app = express();
app.use(cors());
app.use(express.json());

let syncing = false;
let poller = null;

function publicEvent(event, raw) {
  if (!event) return null;
  if (raw) return event;
  const { hex, repr, ...rest } = event;
  return rest;
}

function parseLimitOffset(query) {
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  return { limit, offset };
}

function requestContext(req) {
  return resolveRequestContext(req.query?.network ?? req.body?.network);
}

function networkEnvelope(ctx) {
  return {
    network: ctx.network,
    networkSource: ctx.networkSource,
    contract: ctx.contract,
    stacksApiUrl: ctx.stacksApiUrl,
  };
}

app.get("/health", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    const sync = await getSyncState(ctx);
    res.json({
      ok: true,
      ...networkEnvelope(ctx),
      redis: true,
      contracts: config.contracts,
      defaultNetwork: config.defaultNetwork,
      sync,
    });
  } catch (error) {
    if (error.status === 400) {
      next(error);
      return;
    }
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/catalog", (req, res, next) => {
  try {
    const ctx = requestContext(req);
    res.json({
      ...networkEnvelope(ctx),
      events: STACKSPOTS_EVENTS,
      notes: {
        values: "Fully unwrapped Clarity JSON. uint/int are strings; optional none is null; principals are strings; buffers are 0x-hex.",
        clarity: "Typed tree matching `values` (type + value) for frontend rendering.",
        pots: "GET /pots status comes from the event key: pre-init=deployed, init-pot/pot-registered/pot mint/join-*=joinable, start-stackspot-*/stake-*=started, cancel-pot/fall-back-cancel=cancelled, claim-pot-reward=claimed.",
        network: "Pass ?network=mainnet or ?network=testnet to select STACKSPOTS_CONTRACT_MAINNET / STACKSPOTS_CONTRACT_TESTNET, Hiro host, and Redis namespace.",
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/events", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const { limit, offset } = parseLimitOffset(req.query);
    const eventName = req.query.event ? String(req.query.event) : null;
    const pot = req.query.pot ? String(req.query.pot) : null;
    const raw = req.query.raw === "1" || req.query.raw === "true";
    const { ids, total } = await listEventIds({ ...ctx, eventName, pot, offset, limit });
    const events = (await getEventsByIds(ids, ctx)).map((event) => publicEvent(event, raw));
    res.json({
      ...networkEnvelope(ctx),
      events,
      total,
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/events/:id", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const id = decodeURIComponent(req.params.id);
    const [event] = await getEventsByIds([id], ctx);
    if (!event) {
      res.status(404).json({ error: "Event not found", id, ...networkEnvelope(ctx) });
      return;
    }
    res.json({ ...networkEnvelope(ctx), event });
  } catch (error) {
    next(error);
  }
});

app.get("/pots", async (req, res, next) => {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !POT_STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${POT_STATUSES.join(", ")}` });
      return;
    }
    const pots = await listPots({ ...ctx, status });
    res.json({ ...networkEnvelope(ctx), pots, total: pots.length, status: status ?? "all" });
  } catch (error) {
    next(error);
  }
});

async function statsHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    let stats = !refresh ? await getCachedStats(ctx) : null;
    if (!stats) {
      const [events, pots] = await Promise.all([listAllEvents(ctx), listPots(ctx)]);
      stats = computeStatistics(events, pots, { stackspotsContract: ctx.contract });
      await setCachedStats(stats, ctx);
    }
    res.json({ ...networkEnvelope(ctx), ...stats });
  } catch (error) {
    next(error);
  }
}

app.get("/stats", statsHandler);
app.get("/pots/stats", statsHandler);

function parseArgsInput(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        const error = new Error("args must be a JSON array");
        error.status = 400;
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error.status) throw error;
      const bad = new Error("args must be valid JSON");
      bad.status = 400;
      throw bad;
    }
  }
  const error = new Error("args must be an array");
  error.status = 400;
  throw error;
}

function resolveReadTarget(req) {
  const params = req.params;
  const query = req.query;
  const body = req.body ?? {};
  const fromQuery = query.address ? String(query.address) : null;

  if (params.function && params.address && params.name) {
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(params.function),
    };
  }

  if (params.address && params.name) {
    if (String(params.address).includes(".")) {
      return {
        parsed: parseContractId(params.address),
        functionName: parseFunctionName(
          params.name ?? body.function ?? query.function ?? config.defaultReadFunction,
        ),
      };
    }
    return {
      parsed: parseContractId(params.address, params.name),
      functionName: parseFunctionName(
        body.function ?? query.function ?? config.defaultReadFunction,
      ),
    };
  }

  return {
    parsed: parseContractId(params.contractId ?? fromQuery),
    functionName: parseFunctionName(
      body.function ?? query.function ?? config.defaultReadFunction,
    ),
  };
}

async function contractReadHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    const { parsed, functionName } = resolveReadTarget(req);
    const sender = String(req.body?.sender ?? req.query.sender ?? parsed.address);
    const args = parseArgsInput(req.body?.args ?? req.query.args);
    const argHexes = serializeArgs(args);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true" || req.body?.refresh === true;
    const cacheKey = `${parsed.contractId}:${functionName}:${sender}:${argHexes.join(",")}`;

    let payload = !refresh ? await getCachedContract(cacheKey, ctx) : null;
    if (!payload) {
      const read = await callReadOnly({
        address: parsed.address,
        name: parsed.name,
        functionName,
        sender,
        arguments: argHexes,
      });
      const decoded = decodeClarityResult(read.result);
      payload = {
        ...networkEnvelope(ctx),
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
      await setCachedContract(cacheKey, payload, ctx);
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
}

app.get("/contracts/:address/:name/:function", contractReadHandler);
app.post("/contracts/:address/:name/:function", contractReadHandler);
app.get("/contracts/:address/:name", contractReadHandler);
app.post("/contracts/:address/:name", contractReadHandler);
app.get("/contracts/:contractId", contractReadHandler);
app.post("/contracts/:contractId", contractReadHandler);
app.get("/contracts", (req, res, next) => {
  if (!req.query.address) {
    res.status(400).json({
      error:
        "Pass a contract address as ADDRESS.NAME via /contracts/:address/:name, /contracts/:address.name, or ?address=",
    });
    return;
  }
  contractReadHandler(req, res, next);
});
app.post("/contracts", (req, res, next) => {
  if (req.body?.address && !req.query.address) {
    req.query.address = String(req.body.address);
  }
  if (!req.query.address) {
    res.status(400).json({
      error: "Pass address as ADDRESS.NAME in the path, query, or JSON body",
    });
    return;
  }
  contractReadHandler(req, res, next);
});

app.post("/sync", async (req, res, next) => {
  try {
    if (syncing) {
      res.status(409).json({ error: "Sync already running" });
      return;
    }
    syncing = true;
    const full = req.query.full === "1" || req.body?.full === true;
    const hasNetwork = req.query.network != null || req.body?.network != null;
    if (hasNetwork) {
      const ctx = requestContext(req);
      requireContract(ctx);
      const result = await runSyncSafe({ full, network: ctx.network, contract: ctx.contract });
      res.json({ ...networkEnvelope(ctx), ...result });
      return;
    }
    const results = await runSyncAll({ full });
    res.json({
      network: "all",
      networkSource: "default",
      defaultNetwork: config.defaultNetwork,
      contracts: config.contracts,
      results,
    });
  } catch (error) {
    next(error);
  } finally {
    syncing = false;
  }
});

app.use((error, _req, res, _next) => {
  console.error("[api]", error);
  res.status(error.status && Number.isInteger(error.status) ? error.status : 500).json({
    error: error.message ?? "Internal error",
  });
});

async function poll() {
  if (syncing || config.syncIntervalMs <= 0) return;
  syncing = true;
  try {
    const results = await runSyncAll();
    for (const result of results) {
      if (result.stored) {
        console.log(
          `[sync] ${result.network} stored ${result.stored} events (total ${result.total}, ${result.mode})`,
        );
      }
    }
  } catch (error) {
    console.error("[poll]", error.message);
  } finally {
    syncing = false;
  }
}

export async function start() {
  await connectRedis();
  const redisUrl = new URL(config.redisUrl);
  if (redisUrl.password) redisUrl.password = "***";
  console.log(`[redis] connected ${redisUrl.toString()}`);

  app.listen(config.port, config.host, () => {
    console.log(`[api] http://127.0.0.1:${config.port}`);
    console.log(`[api] listening on ${config.host}:${config.port}`);
    console.log(`[api] default network ${config.defaultNetwork} ${config.stacksApiUrl}`);
    console.log(`[api] mainnet ${config.contracts.mainnet ?? "(unset)"}`);
    console.log(`[api] testnet ${config.contracts.testnet ?? "(unset)"}`);
  });

  await poll();
  if (config.syncIntervalMs > 0) {
    poller = setInterval(poll, config.syncIntervalMs);
  }
  return { app, poller };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
