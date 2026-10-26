import { getSyncState } from "../cache.js";
import { STACKSPOTS_EVENTS } from "../catalog.js";
import { config } from "../config.js";
import { networkEnvelope, requestContext } from "../http.js";

export function registerOpsRoutes(app, { runSync } = {}) {
  app.get("/health", async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      const sync = await getSyncState(ctx);
      res.json({
        ok: true,
        ...networkEnvelope(ctx),
        redis: true,
        contracts: config.contracts,
        preInitLogsContracts: config.preInitLogsContracts,
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
          state: "GET /state (alias /stats) is homepage counters from logger prints only. No pot live reads.",
          pots: "GET /pots is init-pot prints. Live get-pot-details is GET /pots/:address?refresh=1 or /pots/details.",
          sponsor: "GET /sponsor is every hub sponsor-platform print plus page stats. Lookup is GET /sponsor/:address.",
          profile: "GET /profile/:address is created/joined/sponsored/won from logger prints for that wallet.",
          network: "Pass ?network=mainnet or ?network=testnet.",
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/sync", async (req, res, next) => {
    try {
      if (!runSync) {
        res.status(500).json({ error: "Sync is not configured" });
        return;
      }
      await runSync(req, res);
    } catch (error) {
      next(error);
    }
  });
}
