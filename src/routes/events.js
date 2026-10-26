import { getEventsByIds, listEventIds } from "../cache.js";
import { toPublicEvent } from "../catalog.js";
import {
  networkEnvelope,
  parseLimitOffset,
  requestContext,
  requireContract,
} from "../http.js";

export function registerEventsRoutes(app) {
  app.get("/events", async (req, res, next) => {
    try {
      const ctx = requestContext(req);
      requireContract(ctx);
      const eventName = req.query.event ? String(req.query.event) : null;
      const pot = req.query.pot ? String(req.query.pot) : null;
      const sponsor = req.query.sponsor ? String(req.query.sponsor) : null;
      const all = req.query.all === "1" || req.query.all === "true";
      const { limit, offset } = all
        ? { limit: 1_000_000, offset: 0 }
        : parseLimitOffset(req.query);
      const { ids, total } = await listEventIds({ ...ctx, eventName, pot, sponsor, offset, limit });
      const events = (await getEventsByIds(ids, ctx)).map(toPublicEvent).filter(Boolean);
      res.json({
        ...networkEnvelope(ctx),
        events,
        total,
        limit: all ? events.length : limit,
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
      const publicRow = toPublicEvent(event);
      if (!publicRow) {
        res.status(404).json({ error: "Event not found", id, ...networkEnvelope(ctx) });
        return;
      }
      res.json({ ...networkEnvelope(ctx), event: publicRow });
    } catch (error) {
      next(error);
    }
  });
}
