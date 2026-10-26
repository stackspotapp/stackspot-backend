import cors from "cors";
import express from "express";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactStoredEvents,
  connectRedis,
  rebuildSponsorsFromEvents,
} from "./cache.js";
import { assertConfiguredContracts, config, requireContract } from "./config.js";
import { networkEnvelope, requestContext } from "./http.js";
import { registerContractRoutes } from "./routes/contracts.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerOpsRoutes } from "./routes/ops.js";
import { registerPotsRoutes } from "./routes/pots.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerSponsorRoutes } from "./routes/sponsor.js";
import { registerStateRoutes } from "./routes/state.js";
import { runSyncAll, runSyncSafe } from "./sync.js";

const app = express();
app.use(cors());
app.use(express.json());

let syncing = false;
let poller = null;

async function handleSync(req, res) {
  if (syncing) {
    res.status(409).json({ error: "Sync already running" });
    return;
  }
  syncing = true;
  try {
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
      preInitLogsContracts: config.preInitLogsContracts,
      results,
    });
  } finally {
    syncing = false;
  }
}

registerOpsRoutes(app, { runSync: handleSync });
registerStateRoutes(app);
registerProfileRoutes(app);
registerSponsorRoutes(app);
registerPotsRoutes(app);
registerEventsRoutes(app);
registerContractRoutes(app);

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
  assertConfiguredContracts();
  await connectRedis();
  const redisUrl = new URL(config.redisUrl);
  if (redisUrl.password) redisUrl.password = "***";
  console.log(`[redis] connected ${redisUrl.toString()}`);
  for (const network of ["mainnet", "testnet"]) {
    if (!config.contracts[network]) continue;
    await compactStoredEvents({ network, contract: config.contracts[network] }).catch((error) => {
      console.error("[cache] compact", network, error.message);
    });
    await rebuildSponsorsFromEvents({ network, contract: config.contracts[network] }).catch((error) => {
      console.error("[cache] sponsors", network, error.message);
    });
  }

  const server = app.listen(config.port, config.host, () => {
    console.log(`[api] http://127.0.0.1:${config.port}`);
    console.log(`[api] listening on ${config.host}:${config.port}`);
    console.log(`[api] default network ${config.defaultNetwork} ${config.stacksApiUrl}`);
    console.log(`[api] mainnet ${config.contracts.mainnet ?? "(unset)"}`);
    console.log(`[api] testnet ${config.contracts.testnet ?? "(unset)"}`);
  });
  server.on("error", (error) => {
    console.error("[api] listen failed", error.message);
    process.exit(1);
  });

  await poll();
  if (config.syncIntervalMs > 0) {
    poller = setInterval(poll, config.syncIntervalMs);
  }
  return { app, poller, server };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url).toLowerCase() === resolve(entry).toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[uncaughtException]", error);
  });
  start().catch((error) => {
    console.error("[api] startup failed", error);
    process.exit(1);
  });
}

export { app };
