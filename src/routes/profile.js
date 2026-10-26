import { networkEnvelope, requestContext, requireContract } from "../http.js";
import { parseOptionalPrincipal } from "../potDetails.js";
import { computeUserProfile, loadUserProfileEvents } from "../userProfile.js";

async function profileHandler(req, res, next) {
  try {
    const ctx = requestContext(req);
    requireContract(ctx);
    const address = parseOptionalPrincipal(req.params.address ?? req.query.address, "address");
    if (!address) {
      const error = new Error("Pass a Stacks address in the path or ?address=");
      error.status = 400;
      throw error;
    }
    const events = await loadUserProfileEvents(ctx);
    const profile = computeUserProfile(events, address, {
      stackspotsContract: ctx.contract,
      preInitLogsContract: ctx.preInitLogsContract,
    });
    res.json({
      ...networkEnvelope(ctx),
      ...profile,
      stats: {
        created: profile.totals.created,
        joined: profile.totals.joined,
        sponsored: profile.totals.sponsored,
        won: profile.totals.won,
      },
      categories: {
        created: profile.created,
        joined: profile.joined,
        sponsored: profile.sponsored,
        won: profile.won,
      },
    });
  } catch (error) {
    next(error);
  }
}

export function registerProfileRoutes(app) {
  app.get("/profile/:address", profileHandler);
  app.get("/profile", profileHandler);
  app.get("/users/:address", profileHandler);
}
