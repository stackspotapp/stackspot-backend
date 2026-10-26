import { getCachedStats, setCachedStats } from "../cache.js";
import { fetchContractLogsPage } from "../hiro.js";
import {
  loadEventsByNames,
  networkEnvelope,
  requestContext,
  requireContract,
} from "../http.js";
import { computePlatformState } from "../state.js";

const STATE_EVENT_NAMES = [
  "pre-init",
  "init-pot",
  "start-pot",
  "start-stackspot-jackpot",
  "start-stackspot-crowdfund",
  "start-stackspot-sequential-pot",
  "cancel-pot",
  "fall-back-cancel",
  "claim-pot-reward",
  "register-pot",
  "pot-registered",
];

async function hiroLoggerTotals(ctx) {
  try {
    const [preInitPage, stackspotsPage] = await Promise.all([
      ctx.preInitLogsContract
        ? fetchContractLogsPage({ contractId: ctx.preInitLogsContract, limit: 1 })
        : Promise.resolve(null),
      ctx.contract
        ? fetchContractLogsPage({ contractId: ctx.contract, limit: 1 })
        : Promise.resolve(null),
    ]);
    const preInit = Number(preInitPage?.total);
    const stackspots = Number(stackspotsPage?.total);
    return {
      preInit: Number.isFinite(preInit) && preInit >= 0 ? preInit : null,
      stackspots: Number.isFinite(stackspots) && stackspots >= 0 ? stackspots : null,
    };
  } catch (error) {
    console.error("[state] logger contract totals", error.message);
    return { preInit: null, stackspots: null };
  }
}

async function buildState(ctx) {
  const events = await loadEventsByNames(ctx, STATE_EVENT_NAMES);
  const eventTotals = await hiroLoggerTotals(ctx);
  return computePlatformState(events, {
    stackspotsContract: ctx.contract,
    preInitLogsContract: ctx.preInitLogsContract,
    eventTotals,
  });
}

async function stateHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    let stats = !refresh ? await getCachedStats(ctx) : null;
    if (!stats || stats.kind !== "platform-state-v1") {
      stats = await buildState(ctx);
      await setCachedStats(stats, ctx);
    }
    res.json({ ...networkEnvelope(ctx), ...stats });
  } catch (error) {
    next(error);
  }
}

export function registerStateRoutes(app) {
  app.get("/state", stateHandler);
  app.get("/stats", stateHandler);
  app.get("/pots/stats", stateHandler);
}
